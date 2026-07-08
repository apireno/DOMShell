# Changelog

Notable changes to DOMShell — the Chrome extension and the `@apireno/domshell` MCP server.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The two artifacts version independently.

## MCP server `2.0.8` — 2026-07-08 (security)

Server-only patch closing a read/write tier boundary bypass reported privately on 2026-07-08 by **Ugur Ozer, AI Risk Management** (`info@airiskmanagement.ca`) under finding id `DOMSHELL-EVAL-READ-TIER-BYPASS-001`. Assigned CVE / GHSA identifiers ride with the coordinated advisory.

### Security — MCP server (`2.0.8`)

- **`domshell_eval` moved from read tier to write tier** ([`mcp-server/index.ts:113`](https://github.com/apireno/DOMShell/blob/main/mcp-server/index.ts#L113)). Prior versions treated `eval` as read-only in `WRITE_COMMANDS`, allowing it without `--allow-write`. However, `eval` and `js` both dispatch to the same handler ([`src/background/index.ts:1849-1854`](https://github.com/apireno/DOMShell/blob/main/src/background/index.ts#L1849-L1854)) → `handleJs` → `cdp.evaluateJs` → CDP `Runtime.evaluate` with `expression: code, returnByValue: true, awaitPromise: true` and **no `throwOnSideEffect` gate** ([`src/background/cdp_client.ts:660-667`](https://github.com/apireno/DOMShell/blob/main/src/background/cdp_client.ts#L660-L667)). Any JavaScript expression could therefore mutate DOM/window/global state through `domshell_eval` without `--allow-write` — an authorization boundary bypass (CWE-863 class), aggravated by the fact that the tool description explicitly promised "(read-only) ... always available in read-only mode." No new capability was exposed (the same write access was available via `domshell_js` with `--allow-write`), but the tier misclassification meant MCP hosts, tier flags, and audit logs misrepresented the capability being granted.

  The fix moves `eval` into `WRITE_COMMANDS` alongside `js`. The extension code path is unchanged — the tier gate lives entirely in the MCP server, so no Chrome Web Store submission is required. Every downstream check (`isCommandAllowed`, `getCommandTier`, tier annotations, deny messages, audit lines) picks up the new classification automatically.

- **`domshell_eval` MCP annotation changed from `ANNO_READ` to `ANNO_WRITE`** ([`mcp-server/index.ts:887`](https://github.com/apireno/DOMShell/blob/main/mcp-server/index.ts#L887)). MCP hosts (Claude Desktop, Cursor, etc.) render context-aware approval UI based on this annotation. The prior `readOnlyHint: true` misrepresented the capability to hosts and users alike.

- **Documentation aligned with actual capability.** The tool description, `MCP_INSTRUCTIONS`, and the WHEN-TO-USE / IMPORTANT-TIPS sections all previously advertised `eval` as read-only. Every occurrence updated to reflect the true tier and to point read-only DOM inspection needs at `domshell_cat` / `domshell_text` / `domshell_find` instead.

### Notes — MCP server (`2.0.8`)

- **CLI-Anything (HKUDS/CLI-Anything) is unaffected.** Grepped `domshell_backend.py` for `eval` / `js` command usage — zero hits. Their harness uses `ls`, `cd`, `grep`, `click`, `type`, `focus`, `open`, `back`, `forward`, `close`, `refresh` and has never invoked JavaScript-tier commands.
- **Chrome extension is unaffected.** The tier gate lives entirely in the MCP server; the extension processes commands as raw strings and doesn't check tiers. Extension 1.3.4 (2026-07-01 CHANGELOG entry below) remains the latest CWS build.
- **Kgspin QA-UX drives run `--allow-write` for action gates**, so no observed impact. Any drive that previously relied on read-tier `eval` for JS extraction without `--allow-write` will now receive `Error: 'eval' requires --allow-write` — which is the correct behavior; that call was previously being permitted in violation of the documented tier contract.
- **Direct Claude Desktop / Cursor sessions using granular mode** (`--granular`) that called `domshell_eval` without `--allow-write` will get denied. Same story — the fix aligns behavior with the documented contract.
- **SECURITY.md added** (this release) with the disclosure ladder — GitHub Private Vulnerability Reporting first, then npm-published maintainer email. GitHub PVR enabled on the repo so future reporters have a first-class channel instead of guessing at contact addresses.
- Credit: Ugur Ozer (AI Risk Management, `info@airiskmanagement.ca`) — source-review-first responsible disclosure, correct disclosure ladder despite the missing SECURITY.md at time of report.

## Chrome extension `1.3.4` — 2026-07-01

Small hardening patch, paired with MCP server 2.0.7's response-validation gate. Companion release: extension surfaces the actual `chrome.tabs` failure reason on a failed lane mint so that when the server-side gate fires (`MINT-FAIL: laneId=null`), the drive gets an actionable string instead of just "no lane id."

### Changed — Chrome extension (`1.3.4`)

- **`createAgentLane` now returns the ANSI-stripped error string from `groupNew`** on failure ([`src/background/index.ts:198`](https://github.com/apireno/DOMShell/blob/main/src/background/index.ts#L198)). Previously the return value was discarded (`await groupNew(args);` at old line 208), so when `chrome.tabs.create` returned a tab without an id, or `chrome.tabs.group` threw a `Tabs cannot be edited right now` / `Grouping is not editable` / similar, the error message was thrown away and `sessionGroupId` just stayed null. The WS `RESULT` then carried `laneId: null` with no diagnostic — the MCP server's 2.0.7 gate could only report "no lane id" without knowing why. Now `createAgentLane`'s return type is `Promise<string | null>`: null on success, the error string on failure.
- **EXECUTE handler at `src/background/index.ts:605` surfaces the mint error via the WS `RESULT`** when `msg.groupId === "new"` and `createAgentLane` returns a non-null string. Reply format: `Error: lane mint failed at extension — <actual chrome.tabs error>`. The MCP server's `MINT-FAIL:` audit line and the drive-facing error both carry the upstream reason.

### Notes — Chrome extension (`1.3.4`)

- **Paired with MCP server 2.0.7's response-validation gate.** The two changes work together: server-side, 2.0.7 refuses to forward the extension's payload when `laneId=null` on a `group_id="new"` call. Extension-side, 1.3.4 makes that null case carry a specific reason. Neither is useful in isolation — both together turn a silent-shared-fallback hazard into a fail-closed error with a diagnostic.
- **Triggering context**: the kgspin QA-UX bug report `docs/handovers/DOMSHELL-BUG-lane-isolation-intermittent-20260630.md`. Root cause turned out to be environmental (stale orphan proxy processes + concurrent DOMShell consumer creating WS-holder contention), not a DOMShell code bug — post-cleanup and 1.3.4-bridged, mints landed cleanly against the same drive shape that had been failing. 1.3.4 stands as defense-in-depth: if the same contention pattern recurs anywhere, the specific Chrome API failure is now visible in the reply text, not hidden.
- Zero wire-schema changes. HKUDS/CLI-Anything, kgspin drives, Claude Desktop, Cursor callers all continue to work with their current `domshell_execute` calls. The change is only visible when a mint actually fails.

## MCP server `2.0.7` — 2026-06-30

Server-only patch. Three protections in response to the kgspin QA-UX bug report `docs/handovers/DOMSHELL-BUG-lane-isolation-intermittent-20260630.md` — intermittent `group_id:"new"` calls landing on the operator's real browser tabs (Gmail / banking) instead of a fresh isolated lane. All three fixes ship server-side so no Chrome Web Store re-review is needed and no integrator has to change wire calls. Extension 1.3.3 unchanged.

### Added — MCP server (`2.0.7`)

- **New `domshell_about` MCP tool.** Read tool. Returns JSON with `mcp_server_version`, `extension_bridged`, `extension_version` (from the HELLO handshake, live — not from a log line that may be stale), `extension_grouping`, `extension_connected_at`, and the bind ports. Drives can call this at startup to pin-verify who they're actually talking to, and again on any surprising failure to disambiguate stale-log / wrong-extension issues from real bugs. Directly answers ask #3 in the kgspin memo.
- **Response-validation gate on `group_id:"new"` calls.** When a drive requests `group_id="new"` and the extension's `RESULT` doesn't carry a numeric lane id, the server now refuses to return the extension's payload. Instead it surfaces:

  > `Error: lane mint failed — group_id="new" was requested but the extension returned no numeric lane id (got laneId=...). The command was NOT run in a fresh isolated lane. Refusing to return the extension's payload because it may reflect the operator's real browser state (active tab), not an isolated tab group.`

  This is the DOMShell #53 hazard: a failed extension-side mint would silently degrade to `swapToSession(mcpSid)` in the kernel, which cursors on the last known session tab — for a stale MCP session that can mean the operator's active Gmail/banking tab. The gate fail-closes: an actionable error goes back to the drive, no operator-real-browser payload is exposed. Answers ask #1 in the kgspin memo. Well-behaved drives (existing `group_id="new"` calls that succeed extension-side) are unaffected — the gate only fires on failure.

### Changed — MCP server (`2.0.7`)

- **Every `domshell_execute` call now audit-logs the received `group_id` / `initial_url` / `group_name` values verbatim** (plus a truncated command preview) to the audit log. This is the diagnostic that pins down wire-truth in intermittent bugs: the server-side `[DEPRECATION] group_id omitted` reply footer fires only when `group_id === undefined` at the tool handler, so if a drive claims to pass `"new"` and the deprecation fires, the audit line proves whether the field reached the server or was dropped client-side. Turns "sometimes it doesn't work" reports into a reproducible wire trace.
- **HELLO handshake state now cached** for `domshell_about` and audit-logged as a distinct `HELLO: extension v… grouping=…` line (in addition to the existing stdout log). Cleared on WS close/error so `domshell_about` always reports live state, never a stale value from a previous holder.

### Notes — MCP server (`2.0.7`)

- **No Chrome Web Store submission.** All three protections live in the MCP server. Extension 1.3.3 shipped 2026-06-20 remains the latest CWS build.
- **No integrator wire changes.** `domshell_execute` schema is unchanged. `domshell_about` is a new tool but no drive is required to call it — it's a diagnostic surface, not part of any existing flow. HKUDS/CLI-Anything, kgspin QA-UX drives, and Claude Desktop / Cursor callers all continue to work with their current MCP tool calls.
- **Root-cause investigation still open.** The response-validation gate catches the operator-Gmail-exposure hazard regardless of root cause. The audit log lets us determine whether the kgspin bug is (a) the drive intermittently dropping `group_id` before it reaches the wire, (b) multiple concurrent MCP sessions each starting with no lane state, or (c) an extension-side race in `createAgentLane`. Reply to kgspin with the diagnostic path in a separate handover.
- The `v1.3.1 red herring` in the kgspin report — a stale line from `~/Library/Application Support/toolhive/logs/domshell-mcp-server.log` dated 2026-06-18/19 — is exactly what `domshell_about` prevents future integrators from hitting: it reads live handshake state, not the log file. If a real `v1.3.1` extension is currently bridged, `extension_version` says so; if the log line is stale, it says `1.3.3`.

## Chrome extension `1.3.3` — 2026-06-20

Hotfix for a #52-implementation race in `1.3.2` discovered after the `1.3.2` CWS submission was already pending review. **`1.3.3` is functionally identical to `1.3.2` plus one fix** — same #52 + #53 scope, same QA-UX integrator motivation, same forward-compat story. Bumped to `1.3.3` rather than re-submitting `1.3.2` because the Chrome Web Store doesn't allow modifying a pending-review submission.

### Fixed — Chrome extension (`1.3.3`)

- **`groupNew` with `--url` (or MCP `initial_url`) now attaches CDP before returning**, so the agent's first command after lane creation runs against a fully-prepared tab instead of failing with `Error: Tab context lost. Navigate to a tab with 'cd tabs/<id>'`. Mirrors `enterTab`'s attach-before-commit pattern at line 2857. The 1.3.2 implementation set `state.path = ["tabs", <id>]` but never called `cdpSwitchToTab`, so `ensureInsideTab()` threw on `nodeMap.size === 0` for any command issued in the same MCP call as a successful `initial_url` lane creation. Caught by the QA-UX integrator running the canonical `domshell_execute({command:"ls", group_id:"new", group_name:"...", initial_url:"..."})` shape against the unpacked 1.3.2 build.

### Notes — Chrome extension (`1.3.3`)

- If `1.3.2` ships to existing users before `1.3.3` is approved (typical CWS review wait is 3-7 days per submission), the race manifests as `Tab context lost` on the FIRST command in any drive that uses `initial_url`. Workaround for the gap window: after the lane-creation reply lands, issue `cd tabs/<the-tab-id-from-state.path>` before any read. The QA-UX integrator's drive already has async-state retry logic that handles this naturally. Direct Claude Desktop / Cursor sessions using `initial_url` will see the error and need to retry.
- `1.3.3` includes all `1.3.2` changes verbatim: `#53` (no eager SESSION_START lane) and `#52` (`--url` + `groupName` plumb-through). The only delta is the `cdpSwitchToTab` call in `groupNew`'s `--url` path.

## Chrome extension `1.3.2` — 2026-06-20

Two paired kernel fixes that fulfill commitments made by the MCP server's forward-compat parameter ships across 2.0.4–2.0.6, and answer the QA-UX integrator memo about orphan `agent` Chrome tab groups. No new permissions; Chrome Web Store re-review is code-only.

### Changed — Chrome extension (`1.3.2`)

- **The connection-default lane is no longer auto-created on every MCP `SESSION_START`** ([#53](https://github.com/apireno/DOMShell/issues/53)). Previously every MCP connection eagerly minted a Chrome tab group titled `🐚 agent` containing one `about:blank` placeholder, which accumulated as orphan groups across connection cycles and was unattributable to its client. Now isolation happens ONLY when the agent explicitly requests it via `group_id="new"`. **Semantic shift:** `group_id="shared"` and omitted-`group_id` now mean true shared mode (operates on the user's actual browser tabs) instead of "the connection's default isolated lane." This shift was telegraphed by MCP server 2.0.2's deprecation cycle and explicitly called out in 2.0.6's `[DEPRECATION]` reply text. Integrators that always pass explicit `group_id` (e.g. HKUDS/CLI-Anything's harness) are unaffected; integrators using `"shared"` or omitted should migrate to `group_id="new"` for any drive that needs isolation.

### Added — Chrome extension (`1.3.2`)

- **`groupNew` now honors `--url <url>` for the working tab + `groupName` for the title** ([#52](https://github.com/apireno/DOMShell/issues/52)). Paired with MCP server 2.0.4's `initial_url` parameter and 2.0.5's `group_name` parameter — both have been forward-compat-silently-ignored by 1.3.1 since their releases. As of 1.3.2 they actually do what their published descriptions promise:
  - `domshell_execute({command: "...", group_id: "new", initial_url: "https://example.com/article", group_name: "qa-ux-shopkit-sprint12"})` creates a Chrome tab group titled `🐚 qa-ux-shopkit-sprint12` with the article URL loaded directly — no `about:blank` placeholder, no extra `open <url>` round-trip, cursor automatically inside the loaded tab.
  - The in-shell `group new --url <url> <name>` syntax also works for terminal users (e.g. `group new --url https://example.com sprint12`).
- `groupNew` + `createAgentLane` signature changes are additive — callers that don't pass the new params keep the existing behavior verbatim.

### Notes — Chrome extension (`1.3.2`)

- This release closes the forward-compat debt that accumulated across MCP server 2.0.4 / 2.0.5 / 2.0.6. Eager-adopter integrators that have been passing `initial_url` / `group_name` against the published schema now get the optimized behavior automatically.
- **HKUDS/CLI-Anything** is unaffected by either #53 or #52. Their `_call_execute` always sets an explicit `group_id` (`"new"` or captured numeric id) and never uses `"shared"` or omitted. No coordinated release required.
- The QA-UX integrator memo's asks 1 (name from `clientInfo.name`), 2 (reap on disconnect), 3 (auto-close never-navigated), 4 (lane metadata + `group gc`), 5 (lazy creation) are all subsumed by this release: there's no connection-default lane to name, reap, idle-close, list, or lazy-create. Their inline `group close <id>` cleanup remains the right pattern for the explicit lanes they do mint.
- Four kernel-side issues queued for a future bundled extension release ([#47](https://github.com/apireno/DOMShell/issues/47), [#48](https://github.com/apireno/DOMShell/issues/48), [#49](https://github.com/apireno/DOMShell/issues/49), [#51](https://github.com/apireno/DOMShell/issues/51)) are deliberately deferred. Each has a viable workaround and none reflect a felt user pain. They ship when one of them becomes a real friction point, not on a speculative-bundle schedule.

## MCP server `2.0.6` — 2026-06-19

Server-only patch. Documentation + deprecation-message tightening that telegraphs an upcoming semantic shift in DOMShell extension `1.3.2` / DOMShell `3.0.0`. **No behavioral change in 2.0.6** — same wire format, same lane mechanics, same auth model as 2.0.5. The messaging update is forward-compat advance notice so integrators have time to audit before the kernel-side change ships.

### Changed — MCP server (`2.0.6`)

- **`[DEPRECATION] group_id omitted` reply message now warns about the upcoming `"shared"` semantic shift**, not just the upcoming hard-error on omitted. Old text only said "future major release will require an explicit group_id"; new text additionally says:

  > In DOMShell 3.0.0 / extension 1.3.2 (1) omitting `group_id` will be a hard error, and (2) the `"shared"` / omitted-`group_id` semantic will shift to mean "no isolation — operates on the user's actual browser, not a private tab group."

  This is the integrator-facing version of an architecture decision documented as [DOMShell #53](https://github.com/apireno/DOMShell/issues/53): the per-connection isolated lane that's currently created eagerly on every MCP `initialize` (titled `🐚 agent`, with an `about:blank` placeholder) will be removed. Going forward, isolation will happen ONLY when the agent explicitly asks for it via `group_id="new"`. The connection-default lane stops existing.

- **`MCP_INSTRUCTIONS` LANES section rewritten** to recommend `group_id="new"` as the default pattern for any drive that interacts with the page, and to spell out the upcoming `"shared"` semantic clearly. New explicit guidance:

  > If you only ever interact with the page, the rule is: pass `group_id="new"` on the first call, capture the returned `[lane: <id>]` marker, pass that id on every later call. Don't use `"shared"` unless you have a specific reason to operate on the user's real browser.

### Notes — MCP server (`2.0.6`)

- **No code change is required for any current integrator** in 2.0.6. The behavior change lands when extension `1.3.2` ships ([DOMShell #53](https://github.com/apireno/DOMShell/issues/53)). CLI-Anything (HKUDS/CLI-Anything PR #308) is unaffected by either release — their `_call_execute` always sets an explicit `group_id` (`"new"` or a captured numeric id) and never uses `"shared"` or omitted. Their existing test suite stays green.
- Integrators who DO use `group_id="shared"` for isolation today should migrate to `group_id="new"` before extension `1.3.2`. Today's behavior of `"shared"` (per-connection isolated lane) and tomorrow's behavior (no isolation, user's real browser) differ materially for write-tier commands.
- The motivating evidence is documented in the [QA-UX integrator memo at docs/handovers/MEMO-connection-default-lane-naming-and-lifecycle-20260619.md](docs/handovers/MEMO-connection-default-lane-naming-and-lifecycle-20260619.md) — orphan `agent` tab groups accumulating across connection cycles, unattributable to which client created them, and never reaped. The fix collapses every ask in the memo (naming, reaping, idle-close, metadata, lazy creation) into a single change: stop the eager lane creation. Nothing to reap if it never gets created.

## MCP server `2.0.5` — 2026-06-18

Server-only patch. Two unrelated improvements that both reduce friction without requiring a Chrome Web Store cycle: method-aware auth on `/mcp` (so MCP introspection clients work without a bearer token) and a new `group_name` parameter on `domshell_execute` (so integrators can name lanes for garbage-collection sweeps). No Chrome extension changes; no integrator coordination required.

### Changed — MCP server (`2.0.5`)

- **`mcpAuthMiddleware` now inspects the JSON-RPC method.** Read-only protocol methods bypass the bearer-token check; invocation methods continue to require it. The bypass set is:

  | Method | Why it's safe to expose unauthenticated |
  |---|---|
  | `initialize` | Returns protocol version + capabilities — same info already publicly declared in the MCP registry entry |
  | `tools/list` | Returns tool definitions — same info already in the registry |
  | `ping` | Liveness check, returns no data |
  | `notifications/initialized` | One-way client → server, no return value |
  | `notifications/cancelled` | One-way client → server, no return value |

  Everything else — including `tools/call` (the only method that actually invokes a tool and can touch the browser) — keeps the existing bearer-token requirement. The audit log + write/sensitive tier flags + token remain the security boundary for any action.

  **Motivation:** without this change, `thv tui` rendered the workload's Tools tab as `Error: initialize MCP client: transport error: server returned 4xx for initialize POST` because thv's introspection probe doesn't carry the bearer token. MCP Inspector hit the same wall. Codegram (and similar auth-less MCP servers) work in those clients out of the box; DOMShell's deliberate auth posture for action endpoints shouldn't have to take introspection down with it.

  **Threat model delta:** an attacker who can already reach the loopback port can now see the tool list (which is already published in the MCP registry) in addition to "a server is here." No new information disclosure beyond what the public registry already provides. No execution surface change — `tools/call` is unchanged.

### Added — MCP server (`2.0.5`)

- **New `group_name` parameter on `domshell_execute`** — optional, only meaningful when `group_id="new"`. Pairs with 2.0.4's `initial_url`. When set, server forwards `groupName` as a new field on the WS `EXECUTE` message; the future DOMShell extension 1.3.2 will use it to title the lane's Chrome tab group as `🐚 <group_name>` instead of the hard-coded `🐚 agent`. Extension 1.3.1 silently ignores the new field (kernel bridge handler only reads `msg.type / msg.command / msg.groupId / msg.allowedDomains` — verified at `src/background/index.ts:579+`), so the worst-case current behavior is the existing generic title. Recommended convention: `<task-type>-<scope>-<run-id-or-sprint>`, e.g. `qa-ux-shopkit-sprint12` or `research-articles-2026-06-18`. Tracked kernel-side as [DOMShell #52](https://github.com/apireno/DOMShell/issues/52) (paired with `--url` work).

  Example:

  ```json
  {
    "command": "text main",
    "group_id": "new",
    "initial_url": "https://example.com/article",
    "group_name": "qa-ux-shopkit-sprint12"
  }
  ```

  Same multi-line semantics as `initial_url`: forwarded only on the FIRST line of a multi-line `domshell_execute` call and only when `group_id="new"`. Silently dropped otherwise.

- **`MCP_INSTRUCTIONS` extended with a LANE NAMING + GARBAGE COLLECTION section.** Documents the recommended naming convention, the "capture lane id once, reuse for the whole drive, never re-mint" discipline, and the inline-close-or-end-of-round-sweep cleanup pattern. Visible to every agent that fetches the tool's description.

### Notes — MCP server (`2.0.5`)

- Both changes are purely additive on the API surface and forward-compatible. CLI-Anything's flow (which authenticates on every call and doesn't pass `group_name`) is unaffected. Older integrators picking up 2.0.5 get the same behavior as 2.0.4 unless they opt into the new parameter.

## MCP server `2.0.4` — 2026-06-17

Server-only patch. No Chrome extension changes — extension stays at `1.3.1` on the Chrome Web Store; the kernel side of this feature is queued for a future bundled extension `1.3.2` submission. The new parameter ships now as forward-compatible spec; eager adopters can pass it today and get the optimized behaviour automatically the moment the extension upgrade lands.

### Added — MCP server (`2.0.4`)

- **New `initial_url` parameter on `domshell_execute`** — optional, only meaningful when `group_id="new"`. When set, the new lane's working tab is created with that URL loaded instead of `about:blank`. The fresh lane is ready to use by the time `command` runs (no extra `open <url>` round-trip, no dangling `about:blank` tab, cursor lands inside the loaded tab). Example:

  ```json
  {
    "command": "text main",
    "group_id": "new",
    "initial_url": "https://example.com/article"
  }
  ```

  **Compat note:** the parameter is forwarded to the extension as a new field on the WebSocket `EXECUTE` message. **Extension 1.3.2+ honors it; extension 1.3.1 silently ignores unknown JSON fields**, so the worst case on a current installation is exactly today's behaviour (an `about:blank` placeholder is created, the agent's next `open` command opens a second tab — no regression). Safe to always pass; agents that don't know the URL up front continue to omit it.

  Forwarded only on the FIRST line of a multi-line `domshell_execute` call (since that's when the lane is created) and only when `group_id="new"` (silently dropped otherwise). Tracked kernel-side as [DOMShell #52](https://github.com/apireno/DOMShell/issues/52).

### Notes — MCP server (`2.0.4`)

- Pure additive release. Same auth-token / port / host env-var contract as 2.0.3. CLI-Anything (PR #308 integrator) doesn't need any changes — they don't pass `initial_url` today and their flow keeps working unchanged. If they want the optimisation later for their `page open` flow on a fresh REPL, it's a future opt-in PR on their side; no coordination required with this release.

## MCP server `2.0.3` — 2026-06-08

Server-only patch. No Chrome extension changes; the extension stays at `1.3.1`. Adds an optional container + ToolHive install path alongside the existing native stdio install — both coexist; stdio remains the documented default.

### Added — MCP server (`2.0.3`)

- **Optional Dockerized + ToolHive install paths** (Path 2 and Path 3 in the new three-option matrix). The default native install (`npx @apireno/domshell` over stdio, Path 1) is **unchanged and remains the documented default**. New deliverables:
  - `mcp-server/Dockerfile` — `node:20-slim`, non-root, healthcheck, runs `dist/index.js`. Build context is `mcp-server/`.
  - `mcp-server/docker-compose.yml` — direct dockerized run for Path 2.
  - `mcp-server/.dockerignore` — excludes `.git`, `node_modules`, `dist`, `.mcpregistry_*` tokens, audit logs.
  - `docs/deploy/container-and-toolhive.md` — three-options framing, ToolHive recipe, reboot autostart pointers, end-to-end verification.
- **`DOMSHELL_MCP_HOST` env var (and `--host` flag)** for the listener bind address on both the HTTP MCP server (port 3001) and the WebSocket bridge to the Chrome extension (port 9876). **Defaults to `127.0.0.1`**, preserving exact 2.0.2 behavior for every existing native installation. The Dockerfile sets `DOMSHELL_MCP_HOST=0.0.0.0` so port mapping can reach the listener inside a container. **Do not set `0.0.0.0` outside a container or sandboxed VM** — it exposes DOMShell to your LAN; the audit log + token are still the security boundary but loopback binding is the right default for native installs.
- **`DOMSHELL_TOKEN` env var** read as a fallback after the `--token` flag. Lets the `.env` install pattern (used by both Compose and ToolHive's `--env-file`) carry the auth token without command-line interpolation. Random-fallback unchanged for first-time `npx` users with no token set.
- **`DOMSHELL_MCP_PORT` / `DOMSHELL_WS_PORT` env vars** read as fallbacks for the HTTP and WS ports. `MCP_PORT` (the generic name ToolHive injects per workload from its dynamic port allocator) is also read for the HTTP port so the thv-managed path works out of the box. Defaults remain 3001 / 9876.
- **`streamable-http` transport now declared in `server.json`** alongside `stdio`, so the MCP registry advertises both. Stdio stays first / canonical; HTTP transport is opt-in via the container path. No behavior change for existing consumers (they were already on stdio).

### Notes — MCP server (`2.0.3`)

- Pure additive release. No deprecation, no breaking change. The single code-side delta is the bind-host env var; everything else is new files in `mcp-server/` and `docs/deploy/`.
- HKUDS/CLI-Anything PR #308 merged on 2026-06-08 with a HARNESS.md floor of `2.0.2`. Their `npx @apireno/domshell` invocation auto-pulls latest, so they'll silently get 2.0.3 with zero changes required — the new env var is opt-in and their default-loopback usage is unaffected.

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
