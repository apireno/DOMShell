#!/bin/bash
# DOMShell Trial Runner
# Run from your Mac terminal: cd ~/repos/DOMShell/experiment && bash run_domshell_trials.sh
#
# Prerequisites:
#   - Chrome open with DOMShell extension loaded and connected
#   - claude CLI installed and authenticated
#   - domshell MCP server configured in ~/.claude/settings.json or claude_desktop_config.json

set -euo pipefail

RESULTS_DIR="$(cd "$(dirname "$0")" && pwd)/as_results"
mkdir -p "$RESULTS_DIR"

# ── Prompts ──────────────────────────────────────────────────────────────────

TASK1_PROMPT='RULES — read these first:
- You MUST use domshell MCP tools exclusively. No other browser tools.
- You MUST actually navigate to the page and read its content using your tools. Do NOT use prior knowledge or training data to answer. Every fact in your response must come from what you read on the page.
- If you cannot find an element after 3 attempts, skip it and note it as "[not found]".
- Do not explore the page beyond what is needed for the task.
- Be fast and direct. Minimize unnecessary tool calls.
- If you are still working after 15 tool calls, wrap up immediately with whatever you have.
- Return partial results rather than nothing.

TASK:
Go to https://en.wikipedia.org/wiki/Artificial_intelligence. Extract the first paragraph of the article body (not the sidebar or infobox). Then list the first 10 hyperlinks in the article body with their display text and full URLs.

OUTPUT FORMAT:
## First Paragraph
(paste the paragraph text)

## Links
1. [display text](URL)
2. [display text](URL)
... (up to 10)'

TASK2_PROMPT='RULES — read these first:
- You MUST use domshell MCP tools exclusively. No other browser tools.
- You MUST actually navigate to each page and read its content using your tools. Do NOT use prior knowledge or training data to answer. Every fact in your response must come from what you read on the page.
- If you cannot find an element after 3 attempts, skip it and note it as "[not found]".
- Do not explore the page beyond what is needed for the task.
- Be fast and direct. Minimize unnecessary tool calls.
- If you are still working after 20 tool calls, wrap up immediately with whatever you have.
- Return partial results rather than nothing.

TASK:
Go to https://en.wikipedia.org. Search for "machine learning" using the search box. On the results page, click the first result. Then extract the first paragraph of the article and list all items in the "See also" section.

OUTPUT FORMAT:
## First Paragraph
(paste the paragraph text)

## See Also
1. item
2. item
... (all items)'

TASK3_PROMPT='RULES — read these first:
- You MUST use domshell MCP tools exclusively. No other browser tools.
- You MUST actually navigate to each page and read its content using your tools. Do NOT use prior knowledge or training data to answer. Every fact in your response must come from what you read on the page.
- If you cannot find an element after 3 attempts, skip it and note it as "[not found]".
- Do not explore the page beyond what is needed for the task.
- Be fast and direct. Minimize unnecessary tool calls.
- If you are still working after 25 tool calls, wrap up immediately with whatever you have.
- Return partial results rather than nothing.

TASK:
Go to https://en.wikipedia.org/wiki/Large_language_model. Find the table or list of large language models. Extract the names and organizations of the first 5 models listed. Then follow the Wikipedia link for the first model in the list and extract the first paragraph of that model'\''s page.

OUTPUT FORMAT:
## Models
| # | Model | Organization |
|---|-------|-------------|
| 1 | name | org |
| 2 | name | org |
| 3 | name | org |
| 4 | name | org |
| 5 | name | org |

## First Model'\''s Page
(paste the first paragraph from that model'\''s Wikipedia article)'

# ── Trial definitions ────────────────────────────────────────────────────────
# Format: trial_number:task_number:prompt_var_name

TRIALS=(
  "1:1:TASK1_PROMPT"
  "3:1:TASK1_PROMPT"
  "6:2:TASK2_PROMPT"
  "8:2:TASK2_PROMPT"
  "9:3:TASK3_PROMPT"
  "11:3:TASK3_PROMPT"
)

# ── Run each trial ───────────────────────────────────────────────────────────

echo "═══════════════════════════════════════════════════"
echo "  DOMShell Trial Runner — 6 trials"
echo "  Results will be saved to: $RESULTS_DIR/"
echo "═══════════════════════════════════════════════════"
echo ""

for entry in "${TRIALS[@]}"; do
  IFS=':' read -r trial_num task_num prompt_var <<< "$entry"
  prompt="${!prompt_var}"

  echo "──────────────────────────────────────────────────"
  echo "  TRIAL $trial_num  (Task $task_num — DOMShell)"
  echo "──────────────────────────────────────────────────"

  outfile="$RESULTS_DIR/trial_${trial_num}.txt"
  start_ms=$(python3 -c 'import time; print(int(time.time()*1000))')

  # Run claude in print mode with 90s timeout
  # --dangerously-skip-permissions avoids interactive prompts
  # --output-format json gives us structured output with tool call info
  set +e
  timeout 90 claude -p \
    --dangerously-skip-permissions \
    --allowedTools "mcp__domshell__domshell_tabs,mcp__domshell__domshell_here,mcp__domshell__domshell_ls,mcp__domshell__domshell_cd,mcp__domshell__domshell_pwd,mcp__domshell__domshell_cat,mcp__domshell__domshell_find,mcp__domshell__domshell_grep,mcp__domshell__domshell_tree,mcp__domshell__domshell_text,mcp__domshell__domshell_refresh,mcp__domshell__domshell_click,mcp__domshell__domshell_focus,mcp__domshell__domshell_type,mcp__domshell__domshell_navigate,mcp__domshell__domshell_open,mcp__domshell__domshell_execute" \
    --output-format json \
    --no-session-persistence \
    "$prompt" > "$outfile" 2>/dev/null
  exit_code=$?
  set -e

  end_ms=$(python3 -c 'import time; print(int(time.time()*1000))')
  elapsed_ms=$((end_ms - start_ms))
  elapsed_s=$(echo "scale=1; $elapsed_ms / 1000" | bc)

  timed_out="No"
  if [ $exit_code -eq 124 ]; then
    timed_out="Yes"
  fi

  # Count tool calls from JSON output
  tool_calls=$(grep -o '"tool_use"' "$outfile" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$tool_calls" = "0" ]; then
    # fallback: count domshell mentions
    tool_calls=$(grep -oi 'domshell_[a-z]*' "$outfile" 2>/dev/null | wc -l | tr -d ' ')
  fi

  echo "  Time: ${elapsed_s}s | Tool calls: ~${tool_calls} | Timed out: ${timed_out}"
  echo "  Output saved to: $outfile"
  echo ""

  # Write a summary line for easy pasting
  cat >> "$RESULTS_DIR/summary.txt" <<SUMMARY
Trial $trial_num | Task $task_num | Tool calls: $tool_calls | Time: ${elapsed_s}s | Timed out: $timed_out
SUMMARY

  # Small pause between trials to let the extension settle
  sleep 2
done

echo "═══════════════════════════════════════════════════"
echo "  ALL DONE — Results in $RESULTS_DIR/"
echo ""
echo "  Quick summary:"
cat "$RESULTS_DIR/summary.txt"
echo ""
echo "  Next: review each trial_N.txt for correctness,"
echo "  then paste results into results.md"
echo "═══════════════════════════════════════════════════"
