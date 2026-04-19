#!/bin/bash
# escalate-to-cto.sh — Escalate an issue or question from a project repo to the CTO
#
# Fires claude -p into the CTO's home repo (agent-workflow-template) carrying
# full escalation context: current project, sprint, persona, issue description,
# and any supporting files. The CTO's response is written to disk and printed.
#
# CTO repo location (in priority order):
#   1. CTO_REPO environment variable
#   2. .cto-path file in this repo's root (one line: absolute path)
#   3. Prompted interactively (not supported in --non-interactive mode)
#
# Usage:
#   # Minimal — describe the issue inline
#   ./scripts/agentic/escalate-to-cto.sh --issue "Auth token design conflicts with multi-tenant ADR-003"
#
#   # With a context file (sprint plan, review, question doc, etc.)
#   ./scripts/agentic/escalate-to-cto.sh \
#     --issue "VP Eng review flagged a BLOCKER we can't resolve internally" \
#     --context docs/sprints/sprint-05/vp-eng-review.md \
#     --sprint 05
#
#   # From a persona (VP Eng, VP Prod, etc.)
#   ./scripts/agentic/escalate-to-cto.sh \
#     --persona "VP of Engineering" \
#     --issue "Cross-repo data contract conflict on the events schema" \
#     --context docs/architecture/decisions/ADR-007.md
#
#   # Multiple context files
#   ./scripts/agentic/escalate-to-cto.sh \
#     --issue "Need CTO decision on deployment strategy" \
#     --context docs/sprints/sprint-05/sprint-plan.md \
#     --context docs/sprints/sprint-05/vp-eng-review.md
#
# Output:
#   Response written to: docs/sprints/sprint-XX/cto-escalation-{timestamp}.md
#   (or /tmp/cto-escalation-{timestamp}.md if not in a sprint context)
#
# Exit codes:
#   0  Response received and written
#   1  CTO repo not configured — see instructions in output
#   2  Error during escalation call
#
# Compatible with bash 3.2+ (macOS default).

set -euo pipefail

# ─── Locate scripts and repo ──────────────────────────────────────────────────
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
TIMEOUT=300  # 5 minutes for a CTO advisory response

# macOS has no native `timeout`; coreutils ships it as `gtimeout`.
if command -v timeout > /dev/null 2>&1; then
    TIMEOUT_BIN="timeout"
elif command -v gtimeout > /dev/null 2>&1; then
    TIMEOUT_BIN="gtimeout"
else
    echo "Warning: neither 'timeout' nor 'gtimeout' found. On macOS: brew install coreutils." >&2
    echo "Proceeding without timeout guard." >&2
    TIMEOUT_BIN=""
fi

# ─── Defaults ─────────────────────────────────────────────────────────────────
ISSUE=""
PERSONA="Dev Team"
SPRINT=""
CONTEXT_FILES=()
NON_INTERACTIVE=0

# ─── Parse arguments ──────────────────────────────────────────────────────────
usage() {
    echo "Usage: $0 --issue TEXT [--persona TEXT] [--sprint XX] [--context FILE] ..." >&2
    echo ""
    echo "  --issue TEXT       Required. The question or issue to escalate."
    echo "  --persona TEXT     Who is escalating (default: Dev Team)"
    echo "  --sprint N         Sprint number for context (auto-detected if in sprint dir)"
    echo "  --context FILE     File to include as supporting context (repeatable)"
    echo "  --non-interactive  Exit with code 1 if CTO repo not configured, don't prompt"
    exit 2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --issue)           ISSUE="$2";           shift 2 ;;
        --persona)         PERSONA="$2";         shift 2 ;;
        --sprint)          SPRINT="$2";          shift 2 ;;
        --context)         CONTEXT_FILES+=("$2"); shift 2 ;;
        --non-interactive) NON_INTERACTIVE=1;    shift 1 ;;
        --help|-h)         usage ;;
        *) echo "Unknown argument: $1" >&2; usage ;;
    esac
done

if [ -z "$ISSUE" ]; then
    echo "Error: --issue is required" >&2; usage
fi

# ─── Find the CTO repo ────────────────────────────────────────────────────────
CTO_REPO=""

# 1. Environment variable
if [ -n "${CTO_REPO:-}" ]; then
    CTO_REPO="$CTO_REPO"
fi

# 2. .cto-path file in repo root
if [ -z "$CTO_REPO" ] && [ -f "${REPO_ROOT}/.cto-path" ]; then
    CTO_REPO=$(cat "${REPO_ROOT}/.cto-path" | tr -d '[:space:]')
fi

# 3. Not found
if [ -z "$CTO_REPO" ]; then
    if [ "$NON_INTERACTIVE" -eq 1 ]; then
        echo "Error: CTO repo not configured." >&2
        echo "Set CTO_REPO env var or create ${REPO_ROOT}/.cto-path with the path to agent-workflow-template." >&2
        exit 1
    fi
    echo ""
    echo "⚠️  CTO repo not configured."
    echo ""
    echo "To configure, create the file ${REPO_ROOT}/.cto-path containing the"
    echo "absolute path to your agent-workflow-template repo. For example:"
    echo ""
    echo "  echo '/Users/yourname/repos/agent-workflow-template' > .cto-path"
    echo ""
    echo "This file is gitignored (local filesystem paths only)."
    echo ""
    exit 1
fi

if [ ! -d "$CTO_REPO" ]; then
    echo "Error: CTO repo path does not exist: $CTO_REPO" >&2
    echo "Check the path in ${REPO_ROOT}/.cto-path or the CTO_REPO env var." >&2
    exit 2
fi

# ─── Determine output file ────────────────────────────────────────────────────
TIMESTAMP="$(date '+%Y%m%d-%H%M%S')"
PROJECT_NAME="$(basename "$REPO_ROOT")"

# Try to determine current sprint from context
if [ -z "$SPRINT" ]; then
    # Check if any context file is in a sprint folder
    for cf in "${CONTEXT_FILES[@]:-}"; do
        if echo "$cf" | grep -qE 'sprint-([0-9]+)'; then
            SPRINT=$(echo "$cf" | grep -oE 'sprint-([0-9]+)' | grep -oE '[0-9]+' | head -1)
            break
        fi
    done
fi

if [ -n "$SPRINT" ]; then
    SPRINT_PAD=$(printf "%02d" "$SPRINT")
    SPRINT_DIR="${REPO_ROOT}/docs/sprints/sprint-${SPRINT_PAD}"
    mkdir -p "$SPRINT_DIR"
    OUTPUT_FILE="${SPRINT_DIR}/cto-escalation-${TIMESTAMP}.md"
else
    OUTPUT_FILE="/tmp/cto-escalation-${PROJECT_NAME}-${TIMESTAMP}.md"
fi

# ─── Build escalation prompt ──────────────────────────────────────────────────
CONTEXT_BLOCK=""
for cf in "${CONTEXT_FILES[@]:-}"; do
    if [ -f "$cf" ]; then
        CONTEXT_BLOCK+="
### Context: $(basename "$cf")
\`Path: $cf\`

$(cat "$cf")

---
"
    else
        echo "Warning: context file not found, skipping: $cf" >&2
    fi
done

SPRINT_LINE=""
if [ -n "$SPRINT" ]; then
    SPRINT_LINE="**Current Sprint:** ${SPRINT}"
fi

ESCALATION_PROMPT="You are receiving an escalation from one of your dev teams.

**From:** ${PERSONA}
**Project:** ${PROJECT_NAME}
**Repo:** ${REPO_ROOT}
${SPRINT_LINE}
**Escalation timestamp:** ${TIMESTAMP}

---

## Issue

${ISSUE}

---

## Supporting Context
${CONTEXT_BLOCK:-
(No additional context files provided. The issue description above is the full context.)
}

---

## What We Need From You

Please provide:
1. **Your ruling / guidance** — a direct answer or decision if one is needed
2. **Reasoning** — why you're recommending this approach (cross-repo implications, existing ADRs, architectural constraints)
3. **Action items** — specific next steps for the escalating team, with file paths where relevant
4. **Any cross-repo implications** — does this affect other repos? If so, which ones and how?

If you need more context before ruling, state exactly what you need and from which file or team.

Read your CTO persona at docs/personas/cto.md before responding.
"

# ─── Fire the CTO call ───────────────────────────────────────────────────────
echo ""
echo "📡 Escalating to CTO..."
echo "   Project: ${PROJECT_NAME}"
echo "   Issue:   ${ISSUE}"
[ -n "$SPRINT" ] && echo "   Sprint:  ${SPRINT}"
echo "   CTO at:  ${CTO_REPO}"
echo ""

# Write header to output file first
{
    echo "# CTO Escalation Response"
    echo ""
    echo "**From:** ${PERSONA} @ ${PROJECT_NAME}"
    echo "**Issue:** ${ISSUE}"
    [ -n "$SPRINT" ] && echo "**Sprint:** ${SPRINT}"
    echo "**Timestamp:** ${TIMESTAMP}"
    echo ""
    echo "---"
    echo ""
} > "$OUTPUT_FILE"

# Change to CTO repo and fire
cd "$CTO_REPO"

RESPONSE=""
EXIT_CODE=0

if [ -n "$TIMEOUT_BIN" ]; then
    RESPONSE=$(echo "$ESCALATION_PROMPT" | env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \
        "$TIMEOUT_BIN" "$TIMEOUT" "$CLAUDE_BIN" -p --max-turns 5 2>&1) || EXIT_CODE=$?
else
    RESPONSE=$(echo "$ESCALATION_PROMPT" | env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \
        "$CLAUDE_BIN" -p --max-turns 5 2>&1) || EXIT_CODE=$?
fi

if [ $EXIT_CODE -eq 124 ]; then
    echo "## CTO RESPONSE: TIMEOUT" >> "$OUTPUT_FILE"
    echo "" >> "$OUTPUT_FILE"
    echo "The CTO call timed out after ${TIMEOUT}s." >> "$OUTPUT_FILE"
    echo ""
    echo "❌ CTO call timed out. Partial response (if any) saved to: $OUTPUT_FILE"
    exit 2
fi

if [ $EXIT_CODE -ne 0 ]; then
    echo "## CTO RESPONSE: ERROR (exit ${EXIT_CODE})" >> "$OUTPUT_FILE"
    echo "" >> "$OUTPUT_FILE"
    echo "$RESPONSE" >> "$OUTPUT_FILE"
    echo ""
    echo "❌ CTO call failed (exit ${EXIT_CODE}). Output saved to: $OUTPUT_FILE"
    exit 2
fi

echo "$RESPONSE" >> "$OUTPUT_FILE"

echo "✅ CTO response received."
echo "   Saved to: $OUTPUT_FILE"
echo ""
echo "════════════════════════════════════════════════════════════"
echo ""
echo "$RESPONSE"
echo ""
echo "════════════════════════════════════════════════════════════"
echo ""
