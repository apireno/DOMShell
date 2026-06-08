# Handoff — add the optional container + ToolHive install option (DOMShell MCP)

**From:** CTO · **Date:** 2026-06-08 · **For:** DOMShell dev team · **Status:** ready to execute on your schedule
**Pattern proven on:** kgspin-codegram (see its `docs/deploy/container-and-toolhive.md`). Canonical reusable guide: `agent-workflow-template/docs/deploy/local-mcp-with-toolhive.md`.

## The ask
Give DOMShell the **same three install options** codegram now has, and document them — **all optional**, the simple/native path stays the default:
1. **Native CLI** (default, unchanged): stdio via `.mcp.json` / `npx`. Nothing new required.
2. **Dockerized** (optional): a container, runnable directly (`docker run`/compose).
3. **ToolHive-managed** (optional): `thv run` the image → `thv list`/`thv logs` (requires Docker).

**The only management tooling we document is ToolHive.** Options 1 & 2 are just "run it."

## DOMShell specifics (you're ahead of codegram)
- **HTTP transport already exists** — `mcp-server/index.ts` imports `StreamableHTTPServerTransport`, and `proxy.ts` is a stdio↔http bridge. So **no transport-code change is needed** (codegram had to add one). Confirm `index.ts` binds the HTTP listener to **`0.0.0.0`** (not `127.0.0.1`) when in a container, and reads host/port from env.
- **Runtime:** Node ≥18, ESM, `main: dist/index.js`. Dockerfile base `node:20-slim`; `npm ci --omit=dev` + `npm run build` (tsc) → `CMD ["node","dist/index.js"]`.
- **Registry:** DOMShell is published to the public MCP registry (`server.json` declares `transport: stdio`). If you add an HTTP/container option, decide whether to advertise it in `server.json` too — but **keep stdio as the default declared transport** so existing consumers are unaffected.

## The recipe (Node)
```dockerfile
# syntax=docker/dockerfile:1
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build
RUN useradd -m -u 10001 app && chown -R app:app /app
USER app
ENV DOMSHELL_MCP_HOST=0.0.0.0 DOMSHELL_MCP_PORT=3001   # bind 0.0.0.0 (see gotcha #1)
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=5 \
  CMD node -e "require('net').connect(3001,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"
CMD ["node","dist/index.js"]
```
Then ToolHive:
```bash
thv run --name domshell --transport streamable-http --target-port 3001 \
  -e <any-config>=... -v /abs/config:/app/config:ro  <image>:latest
thv list ; thv logs domshell
```

## Gotchas the codegram pilot hit (check these)
1. **Bind `0.0.0.0`, not `127.0.0.1`** — a container bound to loopback is unreachable through the published port. (codegram's FastMCP `FASTMCP_*` env didn't override; we set it in code. For Node, pass host/port to the HTTP transport's listen explicitly from env.)
2. **Don't let the runtime re-resolve dev/editable deps at startup** — codegram's `uv run` tripped on an optional path dep; for Node, `npm ci --omit=dev` + run `dist/` directly avoids dev-dep surprises.
3. **Config is injected, never baked** (FLEET-ADR-001) — mount tokens/config read-only at runtime; don't `COPY` secrets (you have `.mcpregistry_*` tokens — make sure `.dockerignore` excludes them).
4. **Reboot autostart** is only for the ToolHive path: needs Docker-Desktop-on-login + a one-shot launchd agent running `thv restart --all` (see codegram `ops/toolhive/` + `ops/launchd/com.kgspin.codegram.toolhive.plist` for the template).

## Deliverables
- `Dockerfile` + `.dockerignore` (excludes `.git`, `node_modules`, `dist` if you rebuild, **`.mcpregistry_*` tokens**, config).
- Optional `docker-compose.yml` for the run-dockerized path.
- `docs/deploy/container-and-toolhive.md` in this repo (mirror codegram's), framing all three options as **optional** with stdio as the default.
- Verify end-to-end: an MCP streamable-http client → `thv` proxy → container returns a real tool result.

## Constraints
- **Optional, never required** — Docker/ToolHive must not become a dependency of DOMShell; the native stdio path stays the documented default.
- No secrets in the image; config via env/mounts.

— CTO
