# DOMShell — container + ToolHive deploy (OPTIONAL install option)

**Status:** added 2026-06-08 as Path 2 / Path 3 of a three-option install matrix. The reusable cross-project pattern lives in `agent-workflow-template/docs/deploy/local-mcp-with-toolhive.md`; this is the DOMShell instance.

> **DOMShell supports three install paths — the container path is OPTIONAL.**
>
> | Path | Description | Requirements |
> |---|---|---|
> | **1. Native CLI (default)** | `npx @apireno/domshell` over stdio | Node ≥ 18, Chrome extension |
> | **2. Dockerized** (this doc, optional) | `docker compose up` — direct container | Docker Desktop, Chrome extension |
> | **3. ToolHive-managed** (this doc, optional) | `thv run` the same image; `thv list` / `thv logs` for visibility | Docker Desktop, ToolHive, Chrome extension |
>
> Path 1 stays the documented default. Paths 2 and 3 exist for users who want lifecycle management across several MCP servers. **None of the container tooling is a hard dependency of DOMShell.**

## Architecture (same in all three paths)

```
┌─────────────────────┐         HTTP /mcp           ┌──────────────────────────┐
│  MCP client         │ ──────────────────────────► │  DOMShell MCP server     │
│  (Claude Desktop,   │      Bearer <token>         │  (port 3001 HTTP)        │
│   CLI-Anything, …)  │                             │  (port 9876 WS bridge)   │
└─────────────────────┘                             └──────────┬───────────────┘
                                                                │
                                                       WS / token-auth
                                                                ▼
                                                    ┌──────────────────────────┐
                                                    │  Chrome extension        │
                                                    │  (background SW driving  │
                                                    │   the user's browser)    │
                                                    └──────────────────────────┘
```

In a container, the same listeners bind inside the container (`0.0.0.0:3001` and `0.0.0.0:9876`); host-side port mapping makes them reachable as `127.0.0.1:3001` / `127.0.0.1:9876` — which is the address the Chrome extension expects by default (`connect <token>` in the side panel).

## Source changes that enabled containerization (additive, env-gated)

Three small changes in `mcp-server/index.ts`, all additive — every existing native install behaves exactly as it did in 2.0.2:

| What | Why |
|---|---|
| `HOST` reads `--host` flag → `DOMSHELL_MCP_HOST` env → `127.0.0.1` default | The Dockerfile sets `DOMSHELL_MCP_HOST=0.0.0.0` so host port mapping reaches the listener. Applied to both the HTTP MCP server and the WS bridge to the Chrome extension. |
| `AUTH_TOKEN` reads `--token` flag → `DOMSHELL_TOKEN` env → random fallback | Lets the `.env` file carry the auth token, so Compose + ToolHive both pick it up via `env_file`/`--env-file` without having to interpolate into a command line. Random fallback still applies for the first-time `npx` user. |
| `MCP_PORT` reads `--mcp-port` flag → `DOMSHELL_MCP_PORT` env → `MCP_PORT` env → `3001` default; `PORT` reads `--port` → `DOMSHELL_WS_PORT` env → `9876` default | The `MCP_PORT` step is the ToolHive convention — `thv` injects `MCP_PORT` per workload (dynamically allocated to whatever port it routes external traffic to internally). Reading it lets the container bind whatever port `thv` tells it to, without per-workload config. |

The Dockerfile DELIBERATELY does NOT bake `DOMSHELL_MCP_PORT=3001` as `ENV` — that would shadow `MCP_PORT` and break the thv-managed path (lesson learned during 2.0.3 dev).

## Files (in this repo)

```
mcp-server/
  Dockerfile                                  # node:20-slim, non-root, healthcheck, dist/index.js
  .dockerignore                               # excludes .git, node_modules, dist, .mcpregistry_*, audit.log
  .env.example                                # token-persistence template (copy to .env, fill DOMSHELL_TOKEN)
  docker-compose.yml                          # Path 2 — direct dockerized run with port mapping
  ops/
    launchd/com.apireno.domshell.toolhive.plist  # Path 3 reboot-autostart agent template
    toolhive/toolhive-autostart.sh               # script the launchd agent runs (waits Docker, thv restart --all)
docs/deploy/
  container-and-toolhive.md                   # this file
```

## Install pattern (shared by Paths 2 and 3)

The auth token must persist across container restarts and host reboots. Shell variables (`export DOMSHELL_TOKEN=...`) don't qualify — they vanish when the terminal closes. The right pattern is a `.env` file in `mcp-server/` that both Compose and ToolHive can read:

```bash
cd mcp-server
cp .env.example .env

# Generate a real token and edit .env to set DOMSHELL_TOKEN=<the value>
openssl rand -hex 24
# Paste the output into the DOMSHELL_TOKEN= line of .env.

# In the DOMShell Chrome extension's side panel:
#   connect <the same token>
# The extension stores it; you only do this once per machine.
```

`mcp-server/.env` is gitignored (matches the `.env` entry already in `.gitignore`) so the token never reaches version control. The `mcp-server/index.ts` server reads `DOMSHELL_TOKEN` from the environment directly (2.0.3+), so neither Compose nor ToolHive needs to interpolate it into a command line — they just need to put the env into the container.

## Path 2 — direct dockerized run

```bash
cd mcp-server
docker compose build     # produces domshell-mcp-server:latest
docker compose up -d
docker compose logs -f
```

The compose file maps `3001` and `9876` to the host. The container reads `DOMSHELL_TOKEN` from `.env` on every start.

Tear down:

```bash
docker compose down
```

## Path 3 — ToolHive-managed

```bash
# Prerequisites: Docker Desktop running; brew tap stacklok/tap && brew install thv
cd mcp-server
docker compose build           # produces domshell-mcp-server:latest

thv run \
  --name domshell-mcp-server \
  --transport streamable-http \
  --target-port 3001 \
  -p 9876:9876 \
  --env-file .env \
  domshell-mcp-server:latest
```

> For a **stable** client URL add `--proxy-port 3002` (ToolHive otherwise assigns a dynamic port). Then point your MCP client at `http://127.0.0.1:3002/mcp`.

Operate:

```bash
thv list                          # domshell-mcp-server: running, URL http://127.0.0.1:<port>/mcp
thv logs domshell-mcp-server      # tail
thv restart domshell-mcp-server
thv stop domshell-mcp-server      # thv rm domshell-mcp-server to remove
```

> **Known interaction with thv's readiness probe (as of thv `v0.29.x` / DOMShell 2.0.3):** ToolHive periodically probes the upstream MCP endpoint to mark the workload "running" in `thv list`. DOMShell gates `/mcp` behind a bearer-token check (the token in your `.env`), so the unauthenticated probe never satisfies the readiness gate even though the proxy chain is healthy and clients with the token reach the server fine. The workload runs and is usable; it just may not appear in `thv list` until the probe is configured to send the token, or DOMShell exposes an unauthenticated health endpoint. Track / file under DOMShell's [next-release backlog](https://github.com/apireno/DOMShell/issues) if this matters to your setup.

## Reboot behavior — what survives, what needs setup

| Path | Survives host reboot? | What you need to do once |
|---|---|---|
| **1. Native CLI** | ✅ Yes, naturally | Nothing. Your MCP client (Claude Desktop, Cursor, …) spawns the `npx` process on demand the first time you use it after login. The token sits in `claude_desktop_config.json` / equivalent and persists by default. |
| **2. Dockerized (compose)** | ✅ Yes, with one toggle | (a) Docker Desktop → Settings → General → ☑ **"Start Docker Desktop when you log in"**. (b) `docker compose up -d` once. From then on `restart: unless-stopped` brings the container back every time Docker comes up. `.env` token persists naturally. |
| **3. ToolHive-managed** | ⚠️ With one additional step | Same Docker Desktop toggle as Path 2, PLUS install the launchd autostart agent below — ToolHive's `thv` proxy is a host process that dies on reboot, so something has to run `thv restart --all` once Docker is alive. |

### Path 3 launchd autostart (one-time setup)

DOMShell ships a template plist + autostart script in `mcp-server/ops/`. The script waits up to 5 minutes for Docker Desktop to come up, then runs `thv restart --all` — which restores every ToolHive workload on the machine (DOMShell, codegram, anything else `thv` is tracking).

```bash
cd mcp-server   # from this repo

# 1. Edit ops/launchd/com.apireno.domshell.toolhive.plist:
#    Replace the placeholder path with the absolute path to YOUR clone of
#    ops/toolhive/toolhive-autostart.sh. launchd does not expand $HOME or
#    relative paths.

# 2. Install the agent:
cp ops/launchd/com.apireno.domshell.toolhive.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.apireno.domshell.toolhive.plist

# 3. Verify:
launchctl list | grep apireno.domshell.toolhive
tail -f /tmp/domshell-toolhive-autostart.log   # appears on next reboot/login
```

**Simulate the reboot recovery without actually rebooting:**

```bash
# Stop everything thv tracks, then run the exact script launchd will run at login:
docker stop $(docker ps --filter "label=toolhive=true" -q) 2>/dev/null
bash mcp-server/ops/toolhive/toolhive-autostart.sh

# Then verify your workloads came back:
thv list
docker ps
```

To remove: `launchctl unload ~/Library/LaunchAgents/com.apireno.domshell.toolhive.plist` then delete the plist.

> **If you're already running another ToolHive autostart agent** (e.g. from a sibling MCP-server project that follows the same pattern), you don't strictly need this one — `thv restart --all` is global and any single agent restores every workload. Two agents loaded simultaneously is harmless (idempotent) but redundant.

## Gotchas (the deploy checklist)

1. **Bind `0.0.0.0`, not `127.0.0.1`** — done by the Dockerfile setting `ENV DOMSHELL_MCP_HOST=0.0.0.0`. Don't set this env var outside a container or sandboxed VM; doing so exposes DOMShell to your LAN. The native install path leaves it unset and falls back to loopback.

2. **Both ports need mapping.** HTTP MCP (3001) is what your MCP client talks to. WS bridge (9876) is what the Chrome extension talks to. Forget the second one and the extension can't drive the server; you'll get auth errors in the side panel.

3. **Token configuration is injected, never baked** (FLEET-ADR-001). The Dockerfile does not `COPY` any secret. Pass `DOMSHELL_TOKEN` via `.env` (Path 2) or `-e` (Path 3). The `.dockerignore` excludes `.mcpregistry_*` so the npm-publish auth tokens never enter the image.

4. **Extension version still matters.** The container only ships the MCP server. Your Chrome extension must be installed separately (Chrome Web Store, 1.3.1 at the time of writing). The container path doesn't change the extension story.

## Verify end-to-end

Quick smoke test once the container is running:

```bash
# 1. Confirm both listeners are reachable
curl -fsS -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:3001/mcp || true
# Expect: HTTP 405 (POST-only endpoint) or HTTP 401 — both mean "listener alive"

# 2. From the DOMShell side panel: run `connect $DOMSHELL_TOKEN`
#    Side panel should show "Connected (authenticated)".

# 3. From an MCP client, call domshell_execute with command "pwd".
#    Reply should end with `[lane: <id>]` — confirms the full path
#    MCP client → container HTTP → WS bridge → Chrome extension → reply.
```

## Constraints

- **Optional, never required.** Docker and ToolHive must not become a dependency of DOMShell. The native stdio install (`npx @apireno/domshell`) remains the documented default.
- **No secrets in the image.** Config via env/mounts; never `COPY` tokens.
- **Defaults preserve loopback binding.** The 2.0.3 env-var change is additive; absent `DOMSHELL_MCP_HOST`, the server binds `127.0.0.1` exactly as 2.0.2 did.

## Relationship to the default install

The native stdio install via `npx @apireno/domshell` is **the default and is not replaced**. All three paths coexist; the choice is per-machine. The Chrome extension story is identical across all three (Chrome Web Store install, side panel `connect <token>`). Nothing here makes Docker or ToolHive a dependency of DOMShell.

— DOMShell maintainers
