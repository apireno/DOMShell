# Experiment: DOMShell vs Claude in Chrome

## Hypothesis

DOMShell's filesystem-metaphor MCP tools are **faster and more token-efficient** than Claude in Chrome's built-in browser tools for structured web extraction tasks. Both approaches use accessibility-tree representations under the hood — the question is which **tool design** lets the LLM work more efficiently.

## What We're Actually Comparing

| | **Method A: DOMShell** | **Method B: Claude in Chrome** |
|---|---|---|
| **Runner** | Claude Code CLI | Claude Desktop (Cowork tab) |
| **How it works** | MCP tools with filesystem metaphor: `cd`, `ls`, `tree`, `find`, `cat`, `text`, `click`, `type`, `navigate` | Built-in browser tools: `read_page`, `find`, `navigate`, `get_page_text`, `computer` (screenshot), `form_input` |
| **Representation** | AX tree mapped to dirs/files | AX tree as structured output + optional screenshots |
| **Navigation model** | `cd` into elements, `..` to go up | ref IDs from `read_page`, direct `navigate` |
| **Content extraction** | `text` (bulk), `cat` (metadata), `find --meta` | `get_page_text` (bulk), `read_page` (structure) |
| **Interaction** | `focus` + `type`, `click` by element name | `form_input` by ref, `computer` click by coordinate |

**Key difference:** Both use the accessibility tree. DOMShell wraps it in a Unix filesystem metaphor (cd/ls/cat). Claude in Chrome exposes it as a structured API (read_page/find). The experiment tests which abstraction an LLM navigates more efficiently.

## Tasks

Three tasks on Wikipedia (stable, no paywalls, consistent layout):

### Task 1: Content Extraction (Read-only)
Extract first paragraph + first 10 body links with titles and URLs from the AI article.

### Task 2: Search + Navigate (Read + Interact)
Go to wikipedia.org, search "machine learning", click the first result, extract first paragraph + "See also" items.

### Task 3: Multi-step Information Gathering (Complex)
Navigate to the LLM article, extract first 5 models from the table with orgs, follow the first model's link, extract its first paragraph.

## Metrics (per trial)

| Metric | How to Measure |
|--------|---------------|
| **Tool calls** | Count of tool invocations |
| **Wall clock time (s)** | Stopwatch: first tool call → final answer |
| **Correctness (0-3)** | Score against `ground_truth.md` |
| **Completeness** | Items found / items requested (e.g., 8/10) |
| **Hallucination** | Binary: any fabricated URL, title, or content? |
| **Timed out?** | Did the 90s hard cap trigger? |
| **Input tokens** | From API logs (if available, otherwise "N/A") |
| **Output tokens** | From API logs (if available, otherwise "N/A") |

**Primary metrics:** Tool calls, wall clock time, correctness. Tokens are secondary (hard to compare cross-platform).

## Design Constraints

### Speed Guardrails
- **Hard timeout: 90 seconds per trial.** If the agent hasn't finished, stop it and record partial results.
- **Max 3 retries per element.** If an element can't be found or clicked after 3 attempts, skip it and move on.
- **No open-ended exploration.** Prompts explicitly say "do not explore the page beyond what's needed."

### Anti-Cheating Rules
- **Fresh session per trial.** New Claude Code session or new Cowork conversation — no carryover.
- **Prompts include a "no prior knowledge" clause.** The LLM must actually navigate and read; it cannot recite Wikipedia from training data.
- **No caching shortcuts.** The prompt says "you must actually fetch and read the page content using your tools."

### Counterbalanced Ordering
Task 1 starts with DOMShell, Task 2 starts with Claude in Chrome, Task 3 starts with DOMShell. This prevents first-mover bias from always favoring the same method.

## Setup Instructions

### Environment A: DOMShell (via Claude Code CLI)

1. Build: `cd ~/repos/DOMShell && npm run build`
2. Load unpacked extension from `dist/` in Chrome
3. Start MCP server:
   ```bash
   cd ~/repos/DOMShell/mcp-server
   npx tsx index.ts --allow-write --allow-sensitive --no-confirm --token test123
   ```
4. In extension options: token `test123`, port `9876`, enable
5. Add to `~/.claude/settings.json`:
   ```json
   {
     "mcpServers": {
       "domshell": {
         "command": "npx",
         "args": ["tsx", "/Users/apireno/repos/DOMShell/mcp-server/index.ts", "--allow-write", "--no-confirm", "--token", "test123"]
       }
     }
   }
   ```
6. Start a new session: `claude`
7. Verify: "Use domshell_tabs to list open tabs"

### Environment B: Claude in Chrome (via Claude Desktop Cowork)

1. Open Claude Desktop
2. Ensure Claude in Chrome extension is installed and connected
3. Open Chrome with a blank tab
4. Use the Cowork tab for trials
5. No MCP server needed — uses built-in Claude in Chrome tools

### Running a Trial

1. **NEW session** (clean context — no carryover)
2. **Copy exact prompt** from `prompts.md`
3. **Start stopwatch** on send
4. **Let agent work** — do NOT intervene
5. **Hard stop at 90 seconds** if not done — record what you have
6. **Stop stopwatch** when final answer appears (or at 90s cap)
7. **Record metrics** in `results.md`
8. **Note the model version** shown in the session

### Run Order (12 trials)

```
Trial 1:  Task 1 — DOMShell
Trial 2:  Task 1 — Claude in Chrome
Trial 3:  Task 1 — DOMShell  (repeat)
Trial 4:  Task 1 — Claude in Chrome (repeat)
Trial 5:  Task 2 — Claude in Chrome       ← starts with CiC (counterbalanced)
Trial 6:  Task 2 — DOMShell
Trial 7:  Task 2 — Claude in Chrome (repeat)
Trial 8:  Task 2 — DOMShell  (repeat)
Trial 9:  Task 3 — DOMShell
Trial 10: Task 3 — Claude in Chrome
Trial 11: Task 3 — DOMShell (repeat)
Trial 12: Task 3 — Claude in Chrome (repeat)
```

Total: **12 trials**, estimated 20-40 min with the 90s cap.

## Completion Criteria

Done when:
- All 12 trials recorded in `results.md`
- Correctness scored against `ground_truth.md`
- `analysis.md` filled with averages and conclusions
- Clear answer to: "Which tool design is faster/more efficient, and for which task types?"
