#!/bin/bash
# DOMShell ToolHive autostart — restore ToolHive-managed MCP workloads after
# a reboot/login. Designed for the Path 3 (thv-managed) install of DOMShell,
# but `thv restart --all` is a global operation that re-establishes EVERY
# ToolHive workload on this machine — so a single copy of this script
# autostarts every thv-tracked MCP server, not just DOMShell.
#
# Why a wrapper (not just `thv restart --all` directly in the plist):
#   Docker Desktop boots ASYNCHRONOUSLY at login and takes ~30–60s. ToolHive's
#   proxy is a host process (not a container) that does NOT survive reboot,
#   so we (1) wait for the Docker socket, (2) `thv restart --all` to re-
#   establish the proxies + ensure the unless-stopped containers are up.
#
# Installed via ops/launchd/com.apireno.domshell.toolhive.plist (RunAtLoad).
# Reference implementation (older kgspin-codegram pilot): adapt PATH below
# if your homebrew prefix or user dir differs.
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin"
LOG="/tmp/domshell-toolhive-autostart.log"

echo "[$(date '+%Y-%m-%dT%H:%M:%S')] autostart: waiting for Docker socket..." >> "$LOG"
# poll up to ~5 min (60 x 5s) for Docker to come up
for _ in $(seq 1 60); do
    if docker info >/dev/null 2>&1; then break; fi
    sleep 5
done

if ! docker info >/dev/null 2>&1; then
    echo "[$(date '+%Y-%m-%dT%H:%M:%S')] Docker not ready after 5 min — giving up." >> "$LOG"
    echo "[$(date '+%Y-%m-%dT%H:%M:%S')] (Is 'Start Docker Desktop when you log in' enabled in Docker Settings → General?)" >> "$LOG"
    exit 1
fi

echo "[$(date '+%Y-%m-%dT%H:%M:%S')] Docker ready; restoring ToolHive workloads (thv restart --all)" >> "$LOG"
thv restart --all >> "$LOG" 2>&1 || \
    echo "[$(date '+%Y-%m-%dT%H:%M:%S')] thv restart --all returned non-zero" >> "$LOG"

echo "[$(date '+%Y-%m-%dT%H:%M:%S')] done. Current workloads:" >> "$LOG"
thv list >> "$LOG" 2>&1
