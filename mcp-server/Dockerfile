# syntax=docker/dockerfile:1
#
# DOMShell MCP server — containerized streamable-HTTP build.
# OPTIONAL install path; the native stdio install (`npx @apireno/domshell`)
# stays the documented default and remains unchanged.
#
# Build context: this Dockerfile expects to be built from the `mcp-server/`
# subdirectory so `npm ci` sees package-lock.json. From the repo root:
#   docker build -t domshell-mcp:latest mcp-server/
# Or via the compose file in this directory:
#   docker compose build

FROM node:20-slim

WORKDIR /app

# Install deps first to keep this layer cached across source-only edits.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Build the TypeScript source. The `prepublishOnly` script also runs tsc,
# but we invoke it explicitly so a stripped image (no .git, no dev deps
# beyond what tsc itself needs at runtime) still produces dist/.
COPY . .
# tsc is a dev dependency — install it ad-hoc for the build, then drop
# node_modules entirely and re-install --omit=dev for the final layer.
RUN npm install --no-save typescript@5.9 \
 && npm run build \
 && rm -rf node_modules \
 && npm ci --omit=dev

# Run as non-root for the usual reasons.
RUN useradd -m -u 10001 app && chown -R app:app /app
USER app

# Container-default bind: listen on all interfaces so the host's port
# mapping can reach the listener. Native installs leave this unset and
# fall back to 127.0.0.1 (defined in index.ts). Do NOT set
# DOMSHELL_MCP_HOST=0.0.0.0 outside a container or sandboxed VM — it
# exposes the server to your LAN.
ENV DOMSHELL_MCP_HOST=0.0.0.0

# NOTE: do NOT bake DOMSHELL_MCP_PORT / DOMSHELL_WS_PORT into the image.
# Code defaults to 3001 / 9876 already, and leaving these unset means
# ToolHive's `MCP_PORT` injection (which it allocates dynamically per
# workload) takes effect via index.ts's env fallback chain. Setting
# DOMSHELL_MCP_PORT in the image would shadow `MCP_PORT` and break the
# thv-managed path (Path 3).

# EXPOSE the MCP HTTP port ONLY — not the WS bridge (9876). ToolHive's
# proxy inspects the image's EXPOSE list to decide which port is the MCP
# transport target; if multiple ports are listed it picks the wrong one
# (observed forwarding to 9876 instead of 3001 in thv v0.29.1 when both
# were exposed). The WS bridge to the Chrome extension still gets
# published to the host via `-p 9876:9876` on `thv run` or `ports:` in
# docker-compose.yml — it just isn't advertised in the image metadata.
EXPOSE 3001

# Healthcheck against the HTTP MCP listener. Doesn't try /mcp directly
# (that needs auth) — just a raw TCP connect, which is what ToolHive's
# proxy is going to do anyway when it routes traffic in.
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=5 \
  CMD node -e "require('net').connect(${DOMSHELL_MCP_PORT:-3001},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"

# Default command — runs the server with the write tier enabled.
# The auth token is read from the DOMSHELL_TOKEN env var (set in the
# .env file at install time — never baked into the image; FLEET-ADR-001).
# Sensitive tier (--allow-sensitive), domain allowlist (--domains), and
# the granular tool surface (--granular) can be added by overriding the
# command in compose or after `--` in `thv run`.
CMD ["node", "dist/index.js", "--allow-write"]
