# Experiment: DOMShell + Nexa (Model Size Comparison)

## Hypothesis

Small local LLMs can perform progressively complex browser extraction tasks using DOMShell's MCP tools, with 4B models succeeding at harder tasks than 1.7B models.

## What We're Testing

Model size (1.7B vs 4B) on nexa serve, using DOMShell in compact mode.

| | **Qwen3-1.7B** | **Qwen3-4B** |
|---|---|---|
| **Runner** | `agent.py` + nexa serve | `agent.py` + nexa serve |
| **Parameters** | 1.7B (MLX 4-bit) | 4B (MLX 4-bit) |
| **Mode** | Compact | Compact |

## Tasks (Progressive Difficulty)

All tasks use the same Wikipedia article: https://en.wikipedia.org/wiki/Artificial_intelligence

| Task | Goal | Expected Calls | Max Turns |
|------|------|----------------|-----------|
| **T1: Title** | Return the page title | 1 | 5 |
| **T2: H1 heading** | Extract the main heading text | 1-2 | 5 |
| **T3: First paragraph** | Extract the first paragraph verbatim | 2-4 | 8 |
| **T4: Count headings** | Count how many h2 sections exist | 2-3 | 8 |
| **T5: Extract 5 links** | Return first 5 article links with text + URL | 3-5 | 10 |

## Trial Matrix

10 trials: 5 tasks x 2 models (compact mode only)

| | Qwen3-1.7B | Qwen3-4B |
|---|---|---|
| **T1: Title** | Trial 1 | Trial 2 |
| **T2: H1 heading** | Trial 3 | Trial 4 |
| **T3: First paragraph** | Trial 5 | Trial 6 |
| **T4: Count headings** | Trial 7 | Trial 8 |
| **T5: Extract 5 links** | Trial 9 | Trial 10 |

## Metrics

- **Correctness** (0-3 scale: 0=wrong, 1=partial, 2=mostly correct, 3=correct)
- **Tool calls** (fewer = more efficient)
- **Hallucination** (binary: did the model fabricate content?)

## How to Reproduce

```bash
# 1. Start nexa serve
nexa serve

# 2. Start DOMShell MCP server (separate terminal)
cd mcp-server && npx tsx index.ts --no-confirm --allow-all

# 3. Run all trials
bash experiments/nexa_claude/run_trials.sh
```

## File Structure

```
experiments/nexa_claude/
├── README.md               <- You are here
├── nexa_prompts.md         <- Task strings and trial matrix
├── run_trials.sh           <- Automated runner script
└── results/
    ├── ground_truth.md     <- Expected answers
    ├── results.md          <- Full trial data (populated after running)
    ├── analysis.md         <- Analysis (populated after running)
    └── raw_output/         <- Raw agent.py output per trial
```
