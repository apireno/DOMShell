# Experiment 1: DOMShell vs Claude in Chrome

## Hypothesis

DOMShell's filesystem-metaphor MCP tools are **as fast or faster** than Claude in Chrome's built-in browser tools for structured web extraction tasks. Both approaches use accessibility-tree representations under the hood — the question is which **tool design** lets the LLM work more efficiently.

## What We're Comparing

| | **Method A: DOMShell** | **Method B: Claude in Chrome (CiC)** |
|---|---|---|
| **Runner** | Claude Desktop — Cowork mode | Claude Desktop — Cowork mode |
| **How it works** | MCP tools with filesystem metaphor: `cd`, `ls`, `find`, `grep`, `text`, `cat`, `read`, `extract_links`, `extract_table`, `submit`, `navigate`, `open` | Built-in browser tools: `read_page`, `find`, `navigate`, `get_page_text`, `computer` (screenshot), `form_input` |
| **Representation** | AX tree mapped to dirs/files | AX tree as structured output + optional screenshots |
| **Navigation model** | `cd` into elements, path resolution (`text main/article/paragraph`), `ls --after/--before` for siblings | ref IDs from `read_page`, direct `navigate` |
| **Content extraction** | `text` (bulk), `extract_links` (links), `extract_table` (tables), `find --meta` (URLs) | `get_page_text` (bulk), `read_page` (structure) |
| **Interaction** | `submit` (atomic form), `click`, `focus` + `type` | `form_input` by ref, `computer` click by coordinate |

**Key difference:** Both use the accessibility tree. DOMShell wraps it in a Unix filesystem metaphor with composable commands (cd/ls/grep/find/text + pipes). Claude in Chrome exposes it as a structured API (read_page/find). The experiment tests which abstraction an LLM navigates more efficiently.

## Tasks

Three tasks on Wikipedia (stable, no paywalls, consistent layout):

**Task 1: Content Extraction (Read-only)** — Extract first paragraph + first 10 body links with titles and URLs from the AI article.

**Task 2: Search + Navigate (Read + Interact)** — Go to wikipedia.org, search "machine learning" using the search box, click the first result, extract first paragraph + "See also" items.

**Task 3: Multi-step Information Gathering (Complex)** — Navigate to the LLM article, extract first 5 models from the table with orgs, follow the first model's link, extract its first paragraph.

## Metrics

| Metric | How to Measure |
|--------|---------------|
| **Tool calls** (primary) | Count of tool invocations in the conversation |
| **Correctness (0-3)** | Score against `ground_truth.md` |
| **Completeness** | Items found / items requested (e.g., 8/10) |
| **Hallucination** | Binary: any fabricated URL, title, or content? |

Wall clock time is informative but hard to measure consistently in Cowork (interactive sessions). Tool call count is the primary efficiency metric.

## Prerequisites

### For Both Methods

- Claude Desktop with Cowork mode
- Chrome browser open

### For DOMShell Trials

1. Build the DOMShell extension: `cd ~/repos/DOMShell && npm run build`
2. Load the unpacked extension from `dist/` in Chrome
3. Start the DOMShell MCP server:
   ```bash
   cd ~/repos/DOMShell/mcp-server
   npx tsx index.ts --allow-write --no-confirm --token YOUR_TOKEN
   ```
4. In the DOMShell extension options: set the token, port `9876`, and enable
5. Connect DOMShell to Claude Desktop. In Claude Desktop's MCP settings, add the DOMShell server using `proxy.ts` to bridge stdio to the running HTTP server:
   ```json
   {
     "mcpServers": {
       "domshell": {
         "command": "npx",
         "args": ["tsx", "PATH_TO/DOMShell/mcp-server/proxy.ts", "--port", "3001", "--token", "YOUR_TOKEN"]
       }
     }
   }
   ```
6. Verify: In a Cowork session, say "Use domshell_tabs to list open tabs." If it returns your Chrome tabs, DOMShell is connected.

### For Claude in Chrome (CiC) Trials

1. Install the Claude in Chrome extension from the Chrome Web Store
2. Connect it to Claude Desktop (it should auto-detect)
3. No MCP server needed — CiC tools are built into Claude Desktop

## How to Run the Experiment

### Running a Single Trial

1. Open a **new Cowork session** in Claude Desktop (clean context — no carryover from previous trials)
2. Copy the exact prompt for that trial from `prompts.md` and paste it
3. Let the agent work — **do NOT intervene** or provide hints
4. When the agent produces its final answer, count the tool calls in the conversation
5. Score the output against `ground_truth.md`
6. Record the metrics

### Trial Order (12 trials total)

Each task is run twice per method (cold + warm). The ordering is counterbalanced so neither method always goes first.

```
Trial 1:  Task 1 — DOMShell            (cold)
Trial 2:  Task 1 — Claude in Chrome     (cold)
Trial 3:  Task 1 — DOMShell            (repeat)
Trial 4:  Task 1 — Claude in Chrome     (repeat)
Trial 5:  Task 2 — Claude in Chrome     (cold, counterbalanced)
Trial 6:  Task 2 — DOMShell            (cold)
Trial 7:  Task 2 — Claude in Chrome     (repeat)
Trial 8:  Task 2 — DOMShell            (repeat)
Trial 9:  Task 3 — DOMShell            (cold)
Trial 10: Task 3 — Claude in Chrome     (cold)
Trial 11: Task 3 — DOMShell            (repeat)
Trial 12: Task 3 — Claude in Chrome     (repeat)
```

### Shortcut: Running All 6 DOMShell Trials in One Session

For practical convenience, all 6 DOMShell trials can be run in a single Cowork session by pasting each prompt sequentially. This means warm trials (3, 8, 11) benefit from conversation context — the agent learns from cold-trial mistakes. This is acceptable as long as CiC trials are treated the same way. Note this in the methodology section of your results.

## Design Constraints

### Guardrails (Built into Prompts)

- **Tool call caps:** 15 (Task 1), 20 (Task 2), 25 (Task 3). If the cap is hit, the agent wraps up with partial results.
- **Max 3 retries per element.** If an element can't be found or clicked after 3 attempts, skip it.
- **No open-ended exploration.** Prompts say "do not explore the page beyond what is needed."
- **No prior knowledge.** Prompts require the agent to actually navigate and read — no reciting from training data.

### Controlling for Bias

- **Same model:** Both methods must use the same Claude model version.
- **Same platform:** Both methods run in Cowork (Claude Desktop), ensuring the same billing path, rate limits, and runtime.
- **Counterbalanced ordering:** Task 2 starts with CiC, not DOMShell, to avoid first-mover bias.
- **Identical task prompts:** The task portion of each prompt is identical across methods — only the tool-constraint preamble differs.

## File Structure

```
expirement_1/
├── README.md               ← You are here
├── prompts.md              ← Copy-paste prompts for each trial
└── results/
    ├── ground_truth.md     ← Expected answers for scoring
    ├── results.md          ← Latest trial data (Round 3)
    ├── analysis.md         ← Latest analysis with roadmap
    ├── first_run/          ← Round 1 results (baseline, before improvements)
    │   ├── results.md
    │   ├── analysis.md
    │   └── domshell_improvements.md  ← Suggestions that drove Round 2/3 changes
    └── second_run/         ← Round 2 results (after new tools, before composition)
        ├── results.md
        └── analysis.md
```

## Results Summary (Round 3)

| Task | DOMShell Avg Calls | CiC Avg Calls | Ratio |
|------|-------------------|---------------|-------|
| T1: Content Extraction | **4.0** | 5.5 | **0.73×** (DOMShell wins) |
| T2: Search + Navigate | 11.0 | 8.0 | 1.38× (CiC wins) |
| T3: Multi-step | **8.0** | 8.0 | **1.0×** (parity) |
| **Overall** | **7.7** | **7.2** | **1.07×** (near-parity) |

See `results/analysis.md` for the full three-round progression and feature gap roadmap.

## Completion Criteria

Done when:
- All 12 trials recorded in `results/results.md`
- Correctness scored against `results/ground_truth.md`
- `results/analysis.md` filled with averages, per-task comparisons, and conclusions
- Clear answer to: "Which tool design is more efficient, and for which task types?"
