# Experiment: DOMShell vs Raw HTML (Interface Comparison)

## Hypothesis

DOMShell's AX-tree filesystem interface provides better structure for small LLMs to extract web content than raw HTML scraping, when using the same model and inference backend.

## What We're Testing

**Core matrix — `[nexa, ollama] x [domshell, html]`:**

| | **DOMShell** | **Raw HTML** |
|---|---|---|
| **Nexa serve** | `agent.py` via MCP | `raw_html_agent.py` via requests+BS4 |
| **Ollama** | `agent.py` via MCP | `raw_html_agent.py` via requests+BS4 |

All 4 cells use the **same model** (Qwen3-4B) with the **same weights**. The only variables are:
1. **Interface** — DOMShell AX-tree vs raw HTML
2. **Backend** — nexa serve vs Ollama (controls for inference differences)

## Why This Experiment

The [nexa_claude experiment](../nexa_claude/) compared different model sizes (1.7B/4B vs 175B+) — an unfair comparison. This experiment holds the model constant and only varies the **interface** the model uses to understand web content. This validates whether DOMShell's design actually helps.

## Tasks

Simplified from nexa_claude to be achievable by a 4B model (1-2 tool calls after page load):

1. **T1: Page title** — Open a Wikipedia article, return the page title
2. **T2: First paragraph** — Open a Wikipedia article, extract the first paragraph
3. **T3: List headings** — Open a Wikipedia article, list all section headings

## Trial Matrix

12 trials: 3 tasks x 2 backends x 2 interfaces

| | Nexa + DOMShell | Nexa + HTML | Ollama + DOMShell | Ollama + HTML |
|---|---|---|---|---|
| **T1: Title** | Trial 1 | Trial 2 | Trial 3 | Trial 4 |
| **T2: Paragraph** | Trial 5 | Trial 6 | Trial 7 | Trial 8 |
| **T3: Headings** | Trial 9 | Trial 10 | Trial 11 | Trial 12 |

All trials: Qwen3-4B, max 10 turns, compact mode for DOMShell.

## Metrics

- **Task completion** (binary: correct answer returned?)
- **Tool calls** (fewer = more efficient)
- **Correctness** (0-3 scale: 0=wrong, 1=partial, 2=mostly correct, 3=correct)
- **Hallucination** (did the model fabricate content?)

## How to Reproduce

```bash
# 1. Start nexa serve (terminal 1)
nexa serve

# 2. Start Ollama (terminal 2)
ollama serve
ollama pull qwen3:4b

# 3. Start DOMShell MCP server (terminal 3, needed for DOMShell trials only)
cd mcp-server && npx tsx index.ts --no-confirm --allow-all

# 4. Run all trials
bash experiments/nexa_interface/run_trials.sh
```

## File Structure

```
experiments/nexa_interface/
├── README.md               <- You are here
├── nexa_prompts.md         <- Task strings and trial matrix
├── run_trials.sh           <- Automated runner script
├── raw_html_agent.py       <- Raw HTML baseline agent
└── results/
    ├── ground_truth.md     <- Expected answers
    ├── results.md          <- Full trial data (populated after running)
    ├── analysis.md         <- Analysis (populated after running)
    └── raw_output/         <- Raw agent output per trial
```
