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

## Tasks (Progressive Difficulty)

All tasks use the same Wikipedia article: https://en.wikipedia.org/wiki/Artificial_intelligence

| Task | Goal | Expected Calls | Max Turns |
|------|------|----------------|-----------|
| **T1: Title** | Return the page title | 1 | 5 |
| **T2: H1 heading** | Extract the main heading text | 1-2 | 5 |
| **T3: First paragraph** | Extract the first paragraph verbatim | 2-4 | 8 |
| **T4: Count headings** | Count how many h2 sections exist | 2-3 | 8 |
| **T5: Extract 5 links** | Return first 5 article links with text + URL | 3-5 | 10 |

Tasks progress from trivial (T1) to challenging (T5) to find where DOMShell and raw HTML diverge in effectiveness.

## Trial Matrix

20 trials: 5 tasks x 2 backends x 2 interfaces

| | Nexa+DOMShell | Nexa+HTML | Ollama+DOMShell | Ollama+HTML |
|---|---|---|---|---|
| **T1: Title** | Trial 1 | Trial 2 | Trial 3 | Trial 4 |
| **T2: H1** | Trial 5 | Trial 6 | Trial 7 | Trial 8 |
| **T3: Paragraph** | Trial 9 | Trial 10 | Trial 11 | Trial 12 |
| **T4: Headings** | Trial 13 | Trial 14 | Trial 15 | Trial 16 |
| **T5: Links** | Trial 17 | Trial 18 | Trial 19 | Trial 20 |

All trials: Qwen3-4B, compact mode for DOMShell.

## Metrics

- **Correctness** (0-3 scale: 0=wrong, 1=partial, 2=mostly correct, 3=correct)
- **Tool calls** (fewer = more efficient)
- **Hallucination** (binary: did the model fabricate content?)

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
bash experiments/nexa_ollama/run_trials.sh
```

## File Structure

```
experiments/nexa_ollama/
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
